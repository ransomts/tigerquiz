# Creating and resuming a game, over HTTP. The live part is GameChannel.
class GamesController < InstructorController
  def create
    body = json_body
    quiz = current_user.quizzes.find_by(slug: body["quizId"].to_s)
    return render json: { ok: false, error: "No such quiz" } unless quiz

    roster = nil
    if body["rosterId"].present?
      roster = current_user.rosters.find_by(slug: body["rosterId"].to_s)
      return render json: { ok: false, error: "No such class list" } unless roster
    end
    playable = Tigerquiz::QuizDocument.prepare(quiz.playable)
    room = Games::Registry.create(quiz: playable, roster: roster&.playable, user: current_user)
    Rails.logger.info("Room #{room.pin} created for \"#{playable["title"]}\" by #{current_user.eppn}")
    render json: room.describe.merge("ok" => true, "hostToken" => room.host_token)
  rescue Tigerquiz::InvalidQuestion => e
    render json: { ok: false, error: e.message }
  end

  # Reopen a game this browser was hosting: the pin and the token it was given.
  def resume
    body = json_body
    Games::Registry.with_room(body["pin"]) do |room|
      unless room && room.user_id == current_user.id && ActiveSupport::SecurityUtils.secure_compare(room.host_token, body["token"].to_s)
        return render json: { ok: false, error: "That game is no longer open" }
      end

      render json: room.describe.merge("ok" => true, "hostToken" => room.host_token)
    end
  end
end
