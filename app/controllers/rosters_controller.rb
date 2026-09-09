# Class lists, edited on the same page as quizzes.
class RostersController < InstructorController
  def index
    render json: current_user.rosters.ordered.map(&:summary)
  end

  def show
    roster = find_roster or return
    render json: roster.document
  end

  def update
    return render json: { error: QuizzesController::BAD_ID }, status: :bad_request unless params[:id].to_s.match?(Quiz::SLUG)

    body = json_body
    students = Tigerquiz::RosterDocument.clean_students(body["students"])
    return render json: { error: "Add at least one student" }, status: :bad_request if students.empty?

    roster = current_user.rosters.find_or_initialize_by(slug: params[:id])
    roster.title = body["title"].to_s.strip.presence || params[:id]
    roster.students = students
    roster.save!
    render json: { ok: true, id: roster.slug, count: students.length }
  end

  def destroy
    roster = find_roster or return
    roster.destroy!
    render json: { ok: true }
  end

  private

  def find_roster
    unless params[:id].to_s.match?(Quiz::SLUG)
      render json: { error: "bad roster id" }, status: :bad_request
      return nil
    end
    roster = current_user.rosters.find_by(slug: params[:id])
    render json: { error: "No such class list" }, status: :not_found unless roster
    roster
  end
end
